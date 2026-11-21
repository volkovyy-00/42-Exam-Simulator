#include <stdio.h>

int	gym_strlen(char *str);

int	main(int argc, char **argv)
{
	if (argc == 2)
		printf("%d\n", gym_strlen(argv[1]));
	return (0);
}
